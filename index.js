const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');

// ========== DATABASE ==========
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

// ========== SELFBOT MANAGER ==========
class SelfbotManager {
    constructor() {
        this.clients = new Map();
        this.claimedTickets = new Map();
    }

    async start(userId, token, categoryId) {
        if (this.clients.has(userId)) await this.stop(userId);

        const client = new SelfbotClient({ checkUpdate: false });

        return new Promise((resolve) => {
            client.once('ready', () => {
                console.log(`[SELFBOT ${userId}] Ready`);
                this.clients.set(userId, { client, categoryId });
                db.prepare('UPDATE user_configs SET is_running = 1 WHERE user_id = ?').run(userId);
                resolve({ success: true, tag: client.user.tag });
            });

            setTimeout(() => {
                if (!client.user) resolve({ success: false, error: 'Login timeout' });
            }, 10000);

            client.ws.on('MESSAGE_CREATE', (packet) => this.handleMessage(userId, client, packet));
            client.on('channelDelete', (ch) => this.handleChannelDelete(userId, ch));
            
            client.login(token).catch(e => resolve({ success: false, error: e.message }));
        });
    }

    handleMessage(userId, client, packet) {
        if (!packet.guild_id) return;
        const current = this.claimedTickets.get(userId);
        if (current && current !== packet.channel_id) return;
        if (!packet.components?.length) return;

        for (const row of packet.components) {
            for (const btn of row.components) {
                const label = (btn.label || '').toLowerCase();
                if (!label.includes('claim')) continue;
                if (current) return;

                // Fire claim
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

                this.claimedTickets.set(userId, packet.channel_id);
                db.prepare('UPDATE user_configs SET current_ticket = ? WHERE user_id = ?')
                  .run(packet.channel_id, userId);
                
                console.log(`[${userId}] Claimed ${packet.channel_id}`);
                this.monitorChannel(userId, client, packet.channel_id);
            }
        }
    }

    monitorChannel(userId, client, channelId) {
        const handler = (msg) => {
            if (msg.channelId !== channelId) return;
            const closed = msg.content?.toLowerCase().includes('closed') || 
                          msg.content?.toLowerCase().includes('close') ||
                          msg.embeds?.some(e => e.description?.toLowerCase().includes('closed'));
            
            if (closed) {
                this.claimedTickets.delete(userId);
                db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
                client.off('messageCreate', handler);
            }
        };
        client.on('messageCreate', handler);
        setTimeout(() => client.off('messageCreate', handler), 86400000);
    }

    handleChannelDelete(userId, channel) {
        const current = this.claimedTickets.get(userId);
        if (current === channel.id) {
            this.claimedTickets.delete(userId);
            db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
        }
    }

    async stop(userId) {
        const data = this.clients.get(userId);
        if (data) {
            await data.client.destroy();
            this.clients.delete(userId);
            this.claimedTickets.delete(userId);
        }
        db.prepare('UPDATE user_configs SET is_running = 0, current_ticket = NULL WHERE user_id = ?').run(userId);
    }
}

const selfbotManager = new SelfbotManager();

// ========== BOT ==========
const bot = new BotClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

function generateKey(duration) {
    const key = 'TKT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const expires = duration === 'lifetime' ? null : Date.now() + (duration * 86400000);
    db.prepare('INSERT INTO keys (key, duration_days, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(key, duration === 'lifetime' ? -1 : duration, Date.now(), expires);
    return key;
}

bot.on('interactionCreate', async (interaction) => {
    // DEFER IMMEDIATELY for all interactions
    if (interaction.isCommand() || interaction.isButton()) {
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch (e) {
            console.log('Defer failed:', e.message);
            return;
        }
    }

    // OWNER COMMANDS
    if (interaction.isCommand() && interaction.user.id === OWNER_ID) {
        const { commandName, options } = interaction;

        if (commandName === 'generatekey') {
            const duration = options.getString('duration');
            const days = duration === 'lifetime' ? 'lifetime' : parseInt(duration);
            const key = generateKey(days);
            
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('🔑 Key Generated')
                    .setDescription(`\`${key}\``)
                    .addFields({ name: 'Duration', value: duration === 'lifetime' ? '♾️ Lifetime' : `${days} days` })
                    .setColor(0x00FF00)]
            });
        }

        if (commandName === 'revokekey') {
            const key = options.getString('key');
            db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(key);
            return interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('🚫 Key Revoked').setDescription(`\`${key}\` revoked`).setColor(0xFF0000)]
            });
        }

        if (commandName === 'revokeuser') {
            const user = options.getUser('user');
            db.prepare('UPDATE keys SET active = 0 WHERE redeemed_by = ?').run(user.id);
            await selfbotManager.stop(user.id);
            db.prepare('DELETE FROM user_configs WHERE user_id = ?').run(user.id);
            return interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('🚫 User Revoked').setDescription(`${user.tag} revoked`).setColor(0xFF0000)]
            });
        }
    }

    // USER COMMANDS
    if (interaction.isCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'redeemkey') {
            const keyStr = options.getString('key');
            const keyData = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(keyStr);
            
            if (!keyData) return interaction.editReply({ content: '❌ Invalid key' });
            if (keyData.redeemed_by) return interaction.editReply({ content: '❌ Already redeemed' });

            const expires = keyData.duration_days === -1 ? null : Date.now() + (keyData.duration_days * 86400000);
            db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?')
              .run(interaction.user.id, Date.now(), expires, keyStr);
            db.prepare('INSERT OR REPLACE INTO user_configs (user_id, is_running) VALUES (?, 0)').run(interaction.user.id);

            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Key Redeemed')
                    .addFields(
                        { name: 'Duration', value: keyData.duration_days === -1 ? 'Lifetime' : `${keyData.duration_days} days` },
                        { name: 'Next', value: 'Use `/manage`' }
                    )
                    .setColor(0x00FF00)]
            });
        }

        if (commandName === 'manage') {
            const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)')
                .get(interaction.user.id, Date.now());
            
            if (!keyData) return interaction.editReply({ content: '❌ No active key. Use `/redeemkey`' });

            const config = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(interaction.user.id) || {};

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('set_token').setLabel(config.token ? '🔐 Update Token' : '🔐 Set Token').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('set_category').setLabel(config.category_id ? '📁 Update Category' : '📁 Set Category').setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('toggle_start')
                    .setLabel(config.is_running ? '🛑 Stop' : '▶️ Start')
                    .setStyle(config.is_running ? ButtonStyle.Danger : ButtonStyle.Success)
                    .setDisabled(!config.token || !config.category_id)
            );

            const embed = new EmbedBuilder()
                .setTitle('🎫 Ticket Claimer')
                .addFields(
                    { name: 'Status', value: config.is_running ? '🟢 Running' : '🔴 Stopped', inline: true },
                    { name: 'Token', value: config.token ? '✅ Set' : '❌ Not set', inline: true },
                    { name: 'Category', value: config.category_id || '❌ Not set', inline: true }
                )
                .setColor(config.is_running ? 0x00FF00 : 0xFFA500);

            return interaction.editReply({ embeds: [embed], components: [row] });
        }
    }

    // BUTTONS
    if (interaction.isButton()) {
        if (interaction.customId === 'set_token') {
            return interaction.showModal({
                title: 'Set Token',
                custom_id: 'token_modal',
                components: [{
                    type: 1,
                    components: [{
                        type: 4,
                        custom_id: 'token_input',
                        label: 'Discord User Token',
                        style: 1,
                        placeholder: 'Paste token...',
                        required: true
                    }]
                }]
            });
        }

        if (interaction.customId === 'set_category') {
            return interaction.showModal({
                title: 'Set Category',
                custom_id: 'category_modal',
                components: [{
                    type: 1,
                    components: [{
                        type: 4,
                        custom_id: 'category_input',
                        label: 'Category ID',
                        style: 1,
                        placeholder: '1234567890123456789',
                        required: true
                    }]
                }]
            });
        }

        if (interaction.customId === 'toggle_start') {
            const config = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(interaction.user.id);
            
            if (config.is_running) {
                await selfbotManager.stop(interaction.user.id);
                return interaction.editReply({ content: '🛑 Stopped', components: [] });
            } else {
                const result = await selfbotManager.start(interaction.user.id, config.token, config.category_id);
                
                if (result.success) {
                    return interaction.editReply({
                        embeds: [new EmbedBuilder()
                            .setTitle('🎫 Started')
                            .setDescription(`Logged in as \`${result.tag}\``)
                            .addFields({ name: 'Mode', value: 'Single-ticket hold' })
                            .setColor(0x00FF00)],
                        components: []
                    });
                } else {
                    return interaction.editReply({ content: `❌ Failed: ${result.error}` });
                }
            }
        }
    }
});

// MODALS
bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === 'token_modal') {
        const token = interaction.fields.getTextInputValue('token_input');
        const testClient = new SelfbotClient({ checkUpdate: false });
        
        try {
            await testClient.login(token);
            const tag = testClient.user.tag;
            await testClient.destroy();
            
            db.prepare('INSERT OR REPLACE INTO user_configs (user_id, token) VALUES (?, ?)')
              .run(interaction.user.id, token);
            
            await interaction.reply({ content: `✅ Validated: **${tag}**`, ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: `❌ Invalid token`, ephemeral: true });
        }
    }

    if (interaction.customId === 'category_modal') {
        const catId = interaction.fields.getTextInputValue('category_input');
        db.prepare('UPDATE user_configs SET category_id = ? WHERE user_id = ?').run(catId, interaction.user.id);
        await interaction.reply({ content: `✅ Category set`, ephemeral: true });
    }
});

bot.once('ready', async () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    const cmds = [
        { name: 'generatekey', description: '[OWNER] Generate key', options: [{ name: 'duration', type: 3, required: true, choices: [{ name: '1 Day', value: '1' }, { name: '7 Days', value: '7' }, { name: '30 Days', value: '30' }, { name: 'Lifetime', value: 'lifetime' }}] },
        { name: 'revokekey', description: '[OWNER] Revoke key', options: [{ name: 'key', type: 3, required: true }] },
        { name: 'revokeuser', description: '[OWNER] Revoke user', options: [{ name: 'user', type: 6, required: true }] },
        { name: 'redeemkey', description: 'Redeem key', options: [{ name: 'key', type: 3, required: true }] },
        { name: 'manage', description: 'Open panel' }
    ];
    
    await bot.application.commands.set(cmds);
});

bot.login(BOT_TOKEN);
