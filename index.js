const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');

// ========== DATABASE SETUP ==========
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
        current_ticket TEXT,
        last_claim INTEGER
    );
`);

// ========== CONFIG ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

// ========== SELFBOT MANAGER ==========
class SelfbotManager {
    constructor() {
        this.clients = new Map();
        this.claimedTickets = new Map();
    }

    async start(userId, token, categoryId) {
        if (this.clients.has(userId)) {
            await this.stop(userId);
        }

        const client = new SelfbotClient({
            checkUpdate: false,
            ws: { properties: { $browser: "Discord iOS" } }
        });

        let ready = false;
        client.once('ready', () => {
            ready = true;
            console.log(`[SELFBOT ${userId}] Ready as ${client.user.tag}`);
        });

        // Raw WS for fastest detection
        client.ws.on('MESSAGE_CREATE', async (packet) => {
            if (!packet.guild_id) return;
            
            const config = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(userId);
            if (!config || !config.is_running) return;
            if (packet.channel_id !== config.current_ticket && this.claimedTickets.get(userId)) return;

            // Check if message has components
            if (!packet.components?.length) return;

            for (const row of packet.components) {
                for (const btn of row.components) {
                    const isButton = btn.type === 2 || btn.type === "BUTTON";
                    const label = (btn.label || '').toLowerCase();
                    
                    if (!isButton || !label.includes('claim')) continue;

                    // Check if already holding a ticket
                    const current = this.claimedTickets.get(userId);
                    if (current && current !== packet.channel_id) {
                        console.log(`[${userId}] Already holding ticket ${current}, skipping ${packet.channel_id}`);
                        continue;
                    }

                    // Fast claim
                    try {
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
                                data: {
                                    component_type: 2,
                                    custom_id: btn.custom_id
                                }
                            }
                        });

                        this.claimedTickets.set(userId, packet.channel_id);
                        db.prepare('UPDATE user_configs SET current_ticket = ? WHERE user_id = ?')
                          .run(packet.channel_id, userId);

                        console.log(`[${userId}] Claimed ${packet.channel_id}`);
                        
                        // Monitor for ticket closure
                        this.monitorTicket(userId, client, packet.channel_id);
                    } catch (e) {
                        console.error(`[${userId}] Claim failed: ${e.message}`);
                    }
                }
            }
        });

        // Monitor ticket channel for closure
        client.on('channelDelete', (channel) => {
            const current = this.claimedTickets.get(userId);
            if (current === channel.id) {
                console.log(`[${userId}] Ticket ${channel.id} closed, releasing`);
                this.claimedTickets.delete(userId);
                db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
            }
        });

        try {
            await client.login(token);
            await new Promise((resolve, reject) => {
                const check = setInterval(() => {
                    if (ready) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
                setTimeout(() => {
                    clearInterval(check);
                    if (!ready) reject(new Error('Login timeout'));
                }, 10000);
            });

            this.clients.set(userId, { client, categoryId });
            db.prepare('UPDATE user_configs SET is_running = 1 WHERE user_id = ?').run(userId);
            return { success: true, tag: client.user.tag };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    monitorTicket(userId, client, channelId) {
        // Listen for close messages in the ticket
        const handler = (message) => {
            if (message.channelId !== channelId) return;
            
            const content = message.content?.toLowerCase() || '';
            const closed = content.includes('closed') || content.includes('close') || 
                          message.embeds?.some(e => e.description?.toLowerCase().includes('closed'));
            
            if (closed || message.components?.length === 0) {
                console.log(`[${userId}] Ticket ${channelId} detected as closed`);
                this.claimedTickets.delete(userId);
                db.prepare('UPDATE user_configs SET current_ticket = NULL WHERE user_id = ?').run(userId);
                client.off('messageCreate', handler);
            }
        };
        
        client.on('messageCreate', handler);
        
        // Cleanup after 24h to prevent memory leak
        setTimeout(() => {
            client.off('messageCreate', handler);
        }, 86400000);
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

    getStatus(userId) {
        return this.clients.has(userId);
    }
}

const selfbotManager = new SelfbotManager();

// ========== DISCORD BOT ==========
const bot = new BotClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

// ========== KEY SYSTEM ==========
function generateKey(duration) {
    const key = 'TKT-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const now = Date.now();
    const expires = duration === 'lifetime' ? null : now + (duration * 86400000);
    
    db.prepare('INSERT INTO keys (key, duration_days, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(key, duration === 'lifetime' ? -1 : duration, now, expires);
    
    return key;
}

function checkKey(key) {
    return db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(key);
}

// ========== COMMANDS ==========
bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    // OWNER COMMANDS
    if (interaction.isCommand() && interaction.user.id === OWNER_ID) {
        const { commandName, options } = interaction;

        if (commandName === 'generatekey') {
            const duration = options.getString('duration');
            const days = duration === 'lifetime' ? 'lifetime' : parseInt(duration);
            const key = generateKey(days);
            
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🔑 Key Generated')
                    .setDescription(`\`${key}\``)
                    .addFields({ name: 'Duration', value: duration === 'lifetime' ? '♾️ Lifetime' : `${days} days` })
                    .setColor(0x00FF00)],
                ephemeral: true
            });
            return;
        }

        if (commandName === 'revokekey') {
            const key = options.getString('key');
            db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(key);
            
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🚫 Key Revoked')
                    .setDescription(`\`${key}\` has been revoked.`)
                    .setColor(0xFF0000)],
                ephemeral: true
            });
            return;
        }

        if (commandName === 'revokeuser') {
            const user = options.getUser('user');
            db.prepare('UPDATE keys SET active = 0 WHERE redeemed_by = ?').run(user.id);
            
            // Stop their selfbot
            await selfbotManager.stop(user.id);
            db.prepare('DELETE FROM user_configs WHERE user_id = ?').run(user.id);
            
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🚫 User Revoked')
                    .setDescription(`All keys for ${user.tag} revoked and selfbot stopped.`)
                    .setColor(0xFF0000)],
                ephemeral: true
            });
            return;
        }
    }

    // USER COMMANDS
    if (interaction.isCommand()) {
        const { commandName, options } = interaction;

        if (commandName === 'redeemkey') {
            const keyStr = options.getString('key');
            const keyData = checkKey(keyStr);
            
            if (!keyData) {
                return interaction.reply({ content: '❌ Invalid or expired key.', ephemeral: true });
            }
            
            if (keyData.redeemed_by) {
                return interaction.reply({ content: '❌ Key already redeemed.', ephemeral: true });
            }

            const now = Date.now();
            const expires = keyData.duration_days === -1 ? null : now + (keyData.duration_days * 86400000);
            
            db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ?, expires_at = ? WHERE key = ?')
              .run(interaction.user.id, now, expires, keyStr);
            
            // Create user config
            db.prepare('INSERT OR REPLACE INTO user_configs (user_id, is_running) VALUES (?, 0)').run(interaction.user.id);
            
            await interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('✅ Key Redeemed')
                    .setDescription(`You now have access to ticket auto-claim!`)
                    .addFields(
                        { name: 'Duration', value: keyData.duration_days === -1 ? 'Lifetime' : `${keyData.duration_days} days` },
                        { name: 'Next Step', value: 'Use `/manage` to configure your selfbot' }
                    )
                    .setColor(0x00FF00)],
                ephemeral: true
            });
            return;
        }

        if (commandName === 'manage') {
            // Check if user has valid key
            const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND active = 1 AND (expires_at > ? OR expires_at IS NULL)')
                .get(interaction.user.id, Date.now());
            
            if (!keyData) {
                return interaction.reply({ content: '❌ You need an active key. Use `/redeemkey`', ephemeral: true });
            }

            const config = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(interaction.user.id) || {};

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('set_token')
                    .setLabel(config.token ? '🔐 Update Token' : '🔐 Set Token')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('set_category')
                    .setLabel(config.category_id ? '📁 Update Category' : '📁 Set Category')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('toggle_start')
                    .setLabel(config.is_running ? '🛑 Stop' : '▶️ Start')
                    .setStyle(config.is_running ? ButtonStyle.Danger : ButtonStyle.Success)
                    .setDisabled(!config.token || !config.category_id)
            );

            const embed = new EmbedBuilder()
                .setTitle('🎫 Ticket Claimer Manager')
                .setDescription('Configure your auto-claim settings below.')
                .addFields(
                    { name: 'Status', value: config.is_running ? '🟢 Running' : '🔴 Stopped', inline: true },
                    { name: 'Token', value: config.token ? `✅ ${config.token.slice(0, 10)}...` : '❌ Not set', inline: true },
                    { name: 'Category', value: config.category_id ? `✅ ${config.category_id}` : '❌ Not set', inline: true },
                    { name: 'Current Ticket', value: config.current_ticket || 'None', inline: true }
                )
                .setColor(config.is_running ? 0x00FF00 : 0xFFA500);

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }
    }

    // BUTTON HANDLERS
    if (interaction.isButton()) {
        const config = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(interaction.user.id) || {};

        if (interaction.customId === 'set_token') {
            await interaction.showModal({
                title: 'Set Selfbot Token',
                custom_id: 'token_modal',
                components: [{
                    type: 1,
                    components: [{
                        type: 4,
                        custom_id: 'token_input',
                        label: 'Discord User Token',
                        style: 1,
                        placeholder: 'Paste your Discord token here...',
                        required: true,
                        min_length: 10
                    }]
                }]
            });
        }

        if (interaction.customId === 'set_category') {
            await interaction.showModal({
                title: 'Set Category ID',
                custom_id: 'category_modal',
                components: [{
                    type: 1,
                    components: [{
                        type: 4,
                        custom_id: 'category_input',
                        label: 'Category ID to Monitor',
                        style: 1,
                        placeholder: '1234567890123456789',
                        required: true
                    }]
                }]
            });
        }

        if (interaction.customId === 'toggle_start') {
            if (!config.token || !config.category_id) {
                return interaction.reply({ content: '❌ Set token and category first!', ephemeral: true });
            }

            if (config.is_running) {
                await selfbotManager.stop(interaction.user.id);
                await interaction.update({
                    embeds: [new EmbedBuilder()
                        .setTitle('🎫 Ticket Claimer Manager')
                        .setDescription('Auto-claim stopped.')
                        .setColor(0xFF0000)],
                    components: []
                });
            } else {
                const result = await selfbotManager.start(interaction.user.id, config.token, config.category_id);
                
                if (result.success) {
                    await interaction.update({
                        embeds: [new EmbedBuilder()
                            .setTitle('🎫 Ticket Claimer Manager')
                            .setDescription(`Started as \`${result.tag}\``)
                            .addFields(
                                { name: 'Mode', value: 'Single-ticket hold (claims next when current closes)' },
                                { name: 'Monitoring', value: `Category: ${config.category_id}` }
                            )
                            .setColor(0x00FF00)],
                        components: []
                    });
                } else {
                    await interaction.reply({ content: `❌ Failed to start: ${result.error}`, ephemeral: true });
                }
            }
        }
    }
});

// Modal submissions
bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;

    if (interaction.customId === 'token_modal') {
        const token = interaction.fields.getTextInputValue('token_input');
        
        // Validate token by attempting login
        const testClient = new SelfbotClient({ checkUpdate: false });
        try {
            await testClient.login(token);
            const tag = testClient.user.tag;
            await testClient.destroy();
            
            db.prepare('INSERT OR REPLACE INTO user_configs (user_id, token, category_id, is_running) VALUES (?, ?, COALESCE((SELECT category_id FROM user_configs WHERE user_id = ?), NULL), COALESCE((SELECT is_running FROM user_configs WHERE user_id = ?), 0))')
              .run(interaction.user.id, token, interaction.user.id, interaction.user.id);
            
            await interaction.reply({ content: `✅ Token validated for **${tag}**`, ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: `❌ Invalid token: ${e.message}`, ephemeral: true });
        }
    }

    if (interaction.customId === 'category_modal') {
        const categoryId = interaction.fields.getTextInputValue('category_input');
        
        db.prepare('UPDATE user_configs SET category_id = ? WHERE user_id = ?').run(categoryId, interaction.user.id);
        await interaction.reply({ content: `✅ Category ID set to \`${categoryId}\``, ephemeral: true });
    }
});

// Register commands
bot.once('ready', async () => {
    console.log(`[BOT] Ready as ${bot.user.tag}`);
    
    const commands = [
        {
            name: 'generatekey',
            description: '[OWNER] Generate a license key',
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
            description: '[OWNER] Revoke a key',
            options: [{
                name: 'key',
                type: 3,
                description: 'Key to revoke',
                required: true
            }]
        },
        {
            name: 'revokeuser',
            description: '[OWNER] Revoke all keys from user',
            options: [{
                name: 'user',
                type: 6,
                description: 'User to revoke',
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
            description: 'Open your ticket claimer panel'
        }
    ];

    await bot.application.commands.set(commands);
    console.log('[BOT] Commands registered');
});

bot.login(BOT_TOKEN);

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('Shutting down...');
    db.close();
    process.exit();
});
