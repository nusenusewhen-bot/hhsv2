const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database('./keys.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (
        key TEXT PRIMARY KEY,
        duration_days INTEGER,
        created_at INTEGER,
        redeemed_by TEXT,
        redeemed_at INTEGER,
        expires_at INTEGER,
        active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS user_configs (
        user_id TEXT PRIMARY KEY,
        token TEXT,
        category_id TEXT,
        is_running INTEGER DEFAULT 0,
        current_ticket TEXT
    );
`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

class SelfbotManager {
    constructor() {
        this.clients = new Map();
        this.claimed = new Map();
        this.processedMessages = new Set();
    }

    async start(userId, token, categoryId) {
        if (this.clients.has(userId)) await this.stop(userId);
        const client = new SelfbotClient({ checkUpdate: false });

        return new Promise((resolve) => {
            client.once('ready', () => {
                this.clients.set(userId, { client, categoryId });
                db.prepare('UPDATE user_configs SET is_running = 1 WHERE user_id = ?').run(userId);
                resolve({ success: true, tag: client.user.tag });
            });

            setTimeout(() => {
                if (!client.user) resolve({ success: false, error: 'Timeout' });
            }, 10000);

            // Multiple detection methods
            client.ws.on('MESSAGE_CREATE', (p) => this.handleWS(userId, client, p, categoryId));
            client.ws.on('MESSAGE_UPDATE', (p) => this.handleWS(userId, client, p, categoryId));
            client.on('messageCreate', (m) => this.handleMessage(userId, client, m, categoryId));
            client.on('messageUpdate', (old, m) => this.handleMessage(userId, client, m, categoryId));
            client.on('channelCreate', (ch) => this.handleChannel(userId, client, ch, categoryId));
            client.on('channelDelete', (ch) => {
                if (this.claimed.get(userId) === ch.id) {
                    this.claimed.delete(userId);
                    db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
                }
            });

            client.login(token).catch(e => resolve({ success: false, error: e.message }));
        });
    }

    hasClaimButton(components) {
        if (!components?.length) return null;
        for (const row of components) {
            for (const btn of row.components) {
                const label = (btn.label || btn.name || '').toLowerCase();
                if (label.includes('claim')) return btn;
            }
        }
        return null;
    }

    async claim(userId, client, channelId, messageId, btn, guildId, applicationId) {
        if (this.claimed.has(userId)) return;
        
        // Prevent double-clicking same message
        const msgKey = `${userId}-${messageId}`;
        if (this.processedMessages.has(msgKey)) return;
        this.processedMessages.add(msgKey);
        setTimeout(() => this.processedMessages.delete(msgKey), 30000);

        try {
            // Method 1: WS broadcast (fastest)
            client.ws.broadcast({
                op: 1,
                d: {
                    type: 3,
                    nonce: Date.now().toString(),
                    guild_id: guildId,
                    channel_id: channelId,
                    message_id: messageId,
                    application_id: applicationId,
                    session_id: client.sessionId,
                    data: { component_type: 2, custom_id: btn.custom_id }
                }
            });

            this.claimed.set(userId, channelId);
            db.prepare('UPDATE user_configs SET current_ticket = ? WHERE user_id = ?').run(channelId, userId);
            console.log(`[${userId}] Claimed ${channelId} via WS`);

            // Method 2 fallback: HTTP API
            setTimeout(() => {
                if (this.claimed.get(userId) === channelId) {
                    this.clickViaAPI(client, guildId, channelId, messageId, applicationId, btn.custom_id);
                }
            }, 500);
        } catch (e) {
            console.log(`[${userId}] Claim error: ${e.message}`);
        }
    }

    async clickViaAPI(client, guildId, channelId, messageId, applicationId, customId) {
        try {
            await client.api.interactions.post({
                data: {
                    type: 3,
                    nonce: Date.now().toString(),
                    guild_id: guildId,
                    channel_id: channelId,
                    message_id: messageId,
                    application_id: applicationId,
                    session_id: client.sessionId,
                    data: { component_type: 2, custom_id: customId }
                }
            });
        } catch (e) {
            console.log(`API click failed: ${e.message}`);
        }
    }

    handleWS(userId, client, packet, categoryId) {
        if (packet.parent_id !== categoryId) return;
        if (this.claimed.has(userId) && this.claimed.get(userId) !== packet.channel_id) return;
        
        const btn = this.hasClaimButton(packet.components);
        if (!btn) return;

        this.claim(userId, client, packet.channel_id, packet.id, btn, packet.guild_id, packet.application_id || packet.author?.id);
    }

    handleMessage(userId, client, message, categoryId) {
        if (message.channel.parentId !== categoryId) return;
        if (this.claimed.has(userId) && this.claimed.get(userId) !== message.channelId) return;
        
        const btn = this.hasClaimButton(message.components);
        if (!btn) return;

        // Try library method first
        message.clickButton(btn.customId).then(() => {
            this.claimed.set(userId, message.channelId);
            db.prepare('UPDATE user_configs SET current_ticket = ? WHERE user_id = ?').run(message.channelId, userId);
            console.log(`[${userId}] Claimed ${message.channelId} via clickButton`);
        }).catch(() => {
            // Fallback to WS
            this.claim(userId, client, message.channelId, message.id, btn, message.guildId, message.applicationId || message.author?.id);
        });
    }

    async handleChannel(userId, client, channel, categoryId) {
        if (channel.parentId !== categoryId) return;
        if (this.claimed.has(userId)) return;
        
        console.log(`[${userId}] New channel: ${channel.name}`);
        
        // Wait for messages
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 200));
            
            try {
                const messages = await channel.messages.fetch({ limit: 5 });
                for (const [, msg] of messages) {
                    const btn = this.hasClaimButton(msg.components);
                    if (btn) {
                        this.handleMessage(userId, client, msg, categoryId);
                        return;
                    }
                }
            } catch (e) {
                console.log(`Fetch error: ${e.message}`);
            }
        }
    }

    async stop(userId) {
        const data = this.clients.get(userId);
        if (data) {
            await data.client.destroy();
            this.clients.delete(userId);
            this.claimed.delete(userId);
        }
        db.prepare('UPDATE user_configs SET is_running = 0, current_ticket = NULL WHERE user_id = ?').run(userId);
    }

    isRunning(userId) {
        return this.clients.has(userId);
    }
}

const manager = new SelfbotManager();
const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

function genKey(duration) {
    const key = 'TKT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const exp = duration === 'lifetime' ? null : Date.now() + (duration * 86400000);
    db.prepare('INSERT INTO keys (key, duration_days, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(key, duration === 'lifetime' ? -1 : duration, Date.now(), exp);
    return key;
}

function hasKey(userId) {
    return db.prepare('SELECT 1 FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)').get(userId, Date.now());
}

async function showPanel(ix) {
    const cfg = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(ix.user.id) || {};
    const running = manager.isRunning(ix.user.id);
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_token').setLabel(cfg.token ? 'Update Token' : 'Set Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_cat').setLabel(cfg.category_id ? 'Update Category' : 'Set Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('toggle')
            .setLabel(running ? 'Stop' : 'Start')
            .setStyle(running ? ButtonStyle.Danger : ButtonStyle.Success)
            .setDisabled(!cfg.token || !cfg.category_id)
    );
    
    const embed = new EmbedBuilder()
        .setTitle('Ticket Claimer')
        .addFields(
            { name: 'Status', value: running ? 'Running' : 'Stopped', inline: true },
            { name: 'Token', value: cfg.token ? 'Set' : 'Not set', inline: true },
            { name: 'Category', value: cfg.category_id || 'Not set', inline: true },
            { name: 'Current Ticket', value: cfg.current_ticket || 'None', inline: true }
        )
        .setColor(running ? 0x00FF00 : 0xFFA500);
    
    return { embeds: [embed], components: [row] };
}

bot.on('interactionCreate', async (ix) => {
    if (ix.isCommand()) {
        try { await ix.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }

        if (ix.user.id === OWNER_ID) {
            const { commandName, options } = ix;
            
            if (commandName === 'generatekey') {
                const dur = options.getString('duration');
                const days = dur === 'lifetime' ? 'lifetime' : parseInt(dur);
                const key = genKey(days);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('Key Generated').setDescription('`' + key + '`').setColor(0x00FF00)] });
            }
            
            if (commandName === 'revokekey') {
                db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(options.getString('key'));
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('Key Revoked').setColor(0xFF0000)] });
            }
            
            if (commandName === 'revokeuser') {
                const user = options.getUser('user');
                db.prepare('UPDATE keys SET active = 0 WHERE redeemed_by = ?').run(user.id);
                await manager.stop(user.id);
                db.prepare('DELETE FROM user_configs WHERE user_id = ?').run(user.id);
                return ix.editReply({ embeds: [new EmbedBuilder().setTitle('User Revoked').setColor(0xFF0000)] });
            }
        }

        const { commandName, options } = ix;
        
        if (commandName === 'redeemkey') {
            const k = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(options.getString('key'));
            if (!k) return ix.editReply('Invalid key');
            if (k.redeemed_by) return ix.editReply('Already used');
            
            const exp = k.duration_days === -1 ? null : Date.now() + (k.duration_days * 86400000);
            db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?')
              .run(ix.user.id, Date.now(), exp, options.getString('key'));
            db.prepare('INSERT OR REPLACE INTO user_configs (user_id) VALUES (?)').run(ix.user.id);
            return ix.editReply({ embeds: [new EmbedBuilder().setTitle('Key Redeemed').setColor(0x00FF00)] });
        }
        
        if (commandName === 'manage') {
            if (!hasKey(ix.user.id)) return ix.editReply('No active key');
            const panel = await showPanel(ix);
            return ix.editReply(panel);
        }
    }

    if (ix.isButton()) {
        if (ix.customId === 'set_token') {
            return ix.showModal({
                title: 'Set Token',
                custom_id: 'mod_token',
                components: [{
                    type: 1,
                    components: [{
                        type: 4,
                        custom_id: 'tok',
                        label: 'Discord User Token',
                        style: 1,
                        placeholder: 'Paste your token here',
                        required: true
                    }]
                }]
            });
        }
        if (ix.customId === 'set_cat') {
            return ix.showModal({
                title: 'Set Category',
                custom_id: 'mod_cat',
                components: [{
                    type: 1,
                    components: [{
                        type: 4,
                        custom_id: 'cat',
                        label: 'Category ID',
                        style: 1,
                        placeholder: '1234567890123456789',
                        required: true
                    }]
                }]
            });
        }
        if (ix.customId === 'toggle') {
            try { await ix.deferReply({ flags: MessageFlags.Ephemeral }); } catch { return; }
            const cfg = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(ix.user.id);
            
            if (manager.isRunning(ix.user.id)) {
                await manager.stop(ix.user.id);
                const panel = await showPanel(ix);
                return ix.editReply(panel);
            } else {
                const res = await manager.start(ix.user.id, cfg.token, cfg.category_id);
                if (res.success) {
                    const panel = await showPanel(ix);
                    return ix.editReply(panel);
                } else {
                    return ix.editReply('Error: ' + res.error);
                }
            }
        }
    }
});

bot.on('interactionCreate', async (ix) => {
    if (!ix.isModalSubmit()) return;
    
    if (ix.customId === 'mod_token') {
        const tok = ix.fields.getTextInputValue('tok');
        const test = new SelfbotClient({ checkUpdate: false });
        try {
            await test.login(tok);
            const tag = test.user.tag;
            await test.destroy();
            db.prepare('INSERT OR REPLACE INTO user_configs (user_id, token) VALUES (?, ?)').run(ix.user.id, tok);
            
            const panel = await showPanel(ix);
            await ix.deferReply({ flags: MessageFlags.Ephemeral });
            await ix.editReply(panel);
        } catch (e) {
            await ix.deferReply({ flags: MessageFlags.Ephemeral });
            await ix.editReply({ content: 'Invalid token' });
        }
    }
    
    if (ix.customId === 'mod_cat') {
        const catId = ix.fields.getTextInputValue('cat');
        db.prepare('UPDATE user_configs SET category_id = ? WHERE user_id = ?').run(catId, ix.user.id);
        
        const panel = await showPanel(ix);
        await ix.deferReply({ flags: MessageFlags.Ephemeral });
        await ix.editReply(panel);
    }
});

bot.once('ready', async () => {
    console.log('[BOT] ' + bot.user.tag);
    
    const commands = [
        {
            name: 'generatekey',
            description: 'Generate a license key',
            options: [{
                name: 'duration',
                type: 3,
                description: 'Key duration',
                required: true,
                choices: [
                    { name: '1 Day', value: '1' },
                    { name: '7 Days', value: '7' },
                    { name: '30 Days', value: '30' },
                    { name: 'Lifetime', value: 'lifetime' }
                ]
            }]
        },
        {
            name: 'revokekey',
            description: 'Revoke a license key',
            options: [{
                name: 'key',
                type: 3,
                description: 'The key to revoke',
                required: true
            }]
        },
        {
            name: 'revokeuser',
            description: 'Revoke all keys from a user',
            options: [{
                name: 'user',
                type: 6,
                description: 'The user to revoke',
                required: true
            }]
        },
        {
            name: 'redeemkey',
            description: 'Redeem a license key',
            options: [{
                name: 'key',
                type: 3,
                description: 'Your license key',
                required: true
            }]
        },
        {
            name: 'manage',
            description: 'Open your control panel'
        }
    ];
    
    await bot.application.commands.set(commands);
    console.log('[BOT] Commands registered');
});

bot.login(BOT_TOKEN);
