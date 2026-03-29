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

            client.ws.on('MESSAGE_CREATE', (p) => this.handle(userId, client, p));
            client.on('channelDelete', (ch) => {
                if (this.claimed.get(userId) === ch.id) {
                    this.claimed.delete(userId);
                    db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
                }
            });

            client.login(token).catch(e => resolve({ success: false, error: e.message }));
        });
    }

    handle(userId, client, packet) {
        if (!packet.guild_id) return;
        if (this.claimed.has(userId) && this.claimed.get(userId) !== packet.channel_id) return;
        if (!packet.components?.length) return;

        for (const row of packet.components) {
            for (const btn of row.components) {
                if (!(btn.type === 2 || btn.type === 'BUTTON')) continue;
                if (!btn.label?.toLowerCase().includes('claim')) continue;
                if (this.claimed.has(userId)) return;

                client.ws.broadcast({
                    op: 1,
                    d: {
                        type: 3,
                        nonce: Date.now().toString(),
                        guild_id: packet.guild_id,
                        channel_id: packet.channel_id,
                        message_id: packet.id,
                        application_id: packet.application_id || packet.author?.id,
                        session_id: client.sessionId,
                        data: { component_type: 2, custom_id: btn.custom_id }
                    }
                });

                this.claimed.set(userId, packet.channel_id);
                db.prepare('UPDATE user_configs SET current_ticket = ? WHERE user_id = ?').run(packet.channel_id, userId);
                this.monitor(userId, client, packet.channel_id);
            }
        }
    }

    monitor(userId, client, channelId) {
        const handler = (msg) => {
            if (msg.channelId !== channelId) return;
            const closed = msg.content?.toLowerCase().includes('closed') || 
                          msg.embeds?.some(e => e.description?.toLowerCase().includes('closed'));
            if (closed) {
                this.claimed.delete(userId);
                db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
                client.off('messageCreate', handler);
            }
        };
        client.on('messageCreate', handler);
        setTimeout(() => client.off('messageCreate', handler), 86400000);
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
            const cfg = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(ix.user.id) || {};
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('set_token').setLabel(cfg.token ? 'Update Token' : 'Set Token').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('set_cat').setLabel(cfg.category_id ? 'Update Category' : 'Set Category').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('toggle').setLabel(cfg.is_running ? 'Stop' : 'Start').setStyle(cfg.is_running ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(!cfg.token || !cfg.category_id)
            );
            
            const embed = new EmbedBuilder()
                .setTitle('Ticket Claimer')
                .addFields(
                    { name: 'Status', value: cfg.is_running ? 'Running' : 'Stopped', inline: true },
                    { name: 'Token', value: cfg.token ? 'Set' : 'Not set', inline: true },
                    { name: 'Category', value: cfg.category_id || 'Not set', inline: true }
                )
                .setColor(cfg.is_running ? 0x00FF00 : 0xFFA500);
            
            return ix.editReply({ embeds: [embed], components: [row] });
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
            if (cfg.is_running) {
                await manager.stop(ix.user.id);
                return ix.editReply('Stopped');
            }
            const res = await manager.start(ix.user.id, cfg.token, cfg.category_id);
            return ix.editReply(res.success ? { embeds: [new EmbedBuilder().setTitle('Started').setDescription(res.tag).setColor(0x00FF00)] } : 'Error: ' + res.error);
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
            return ix.reply({ content: 'Validated: ' + tag, flags: MessageFlags.Ephemeral });
        } catch (e) {
            return ix.reply({ content: 'Invalid token', flags: MessageFlags.Ephemeral });
        }
    }
    
    if (ix.customId === 'mod_cat') {
        db.prepare('UPDATE user_configs SET category_id = ? WHERE user_id = ?').run(ix.fields.getTextInputValue('cat'), ix.user.id);
        return ix.reply({ content: 'Category set', flags: MessageFlags.Ephemeral });
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
