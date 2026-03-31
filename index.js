const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { Client: BotClient, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

puppeteer.use(StealthPlugin());

const db = new Database('./keys.db');
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, duration_days INTEGER, created_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER, expires_at INTEGER, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT, category_id TEXT, guild_id TEXT, is_running INTEGER DEFAULT 0, current_ticket TEXT, last_error TEXT, browser_pid INTEGER);
`);

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!BOT_TOKEN || !OWNER_ID) {
    console.error('[FATAL] Missing BOT_TOKEN or OWNER_ID');
    process.exit(1);
}

const bot = new BotClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const activeClaimers = new Map();

class PuppeteerClaimer {
    constructor(userId, config) {
        this.userId = userId;
        this.token = config.token;
        this.categoryId = config.category_id;
        this.guildId = config.guild_id;
        this.browser = null;
        this.page = null;
        this.isRunning = false;
        this.currentTicket = null;
        this.monitorInterval = null;
        this.claimedChannels = new Set();
    }

    async start() {
        console.log(`[PUPPETEER_START] ${this.userId}`);
        
        try {
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1280,720'
                ]
            });

            const pid = this.browser.process().pid;
            db.prepare('UPDATE users SET browser_pid = ? WHERE user_id = ?').run(pid, this.userId);

            this.page = await this.browser.newPage();
            
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Fixed: Wait for page to be fully loaded before injecting token
            await this.page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' });
            
            // Fixed: Wait for document.body to exist, then inject token
            await this.page.waitForFunction(() => document.readyState === 'complete');
            
            // Fixed: Use evaluateOnNewDocument to ensure localStorage is available
            await this.page.evaluateOnNewDocument((token) => {
                localStorage.setItem('token', `"${token}"`);
            }, this.token);
            
            // Reload to apply token
            await this.page.reload({ waitUntil: 'networkidle2' });
            
            // Fixed: Wait for Discord's actual UI with multiple possible selectors
            await this.page.waitForSelector('nav[aria-label="Servers sidebar"], [class*="guilds"], [class*="sidebar"]', { timeout: 30000 });
            
            console.log(`[PUPPETEER_READY] ${this.userId} - Logged in`);
            this.isRunning = true;
            
            if (this.guildId) {
                await this.navigateToGuild();
            }
            
            this.startMonitoring();
            
            db.prepare('UPDATE users SET is_running = 1, last_error = NULL WHERE user_id = ?').run(this.userId);
            
        } catch (e) {
            console.error(`[PUPPETEER_FAIL] ${this.userId}: ${e.message}`);
            db.prepare('UPDATE users SET is_running = 0, last_error = ? WHERE user_id = ?').run(e.message, this.userId);
            this.stop();
        }
    }

    async navigateToGuild() {
        try {
            const guildSelector = `div[data-list-item-id="guildsnav___${this.guildId}"]`;
            await this.page.waitForSelector(guildSelector, { timeout: 10000 });
            await this.page.click(guildSelector);
            await this.page.waitForTimeout(1000);
            console.log(`[NAVIGATED] Guild ${this.guildId}`);
        } catch (e) {
            console.log(`[NAVIGATE_FAIL] ${this.guildId}: ${e.message}`);
        }
    }

    startMonitoring() {
        console.log(`[MONITOR_START] ${this.userId} | Category: ${this.categoryId}`);
        
        this.monitorInterval = setInterval(async () => {
            if (!this.isRunning || this.currentTicket) return;
            
            try {
                await this.checkForTickets();
            } catch (e) {
                console.error(`[MONITOR_ERR] ${this.userId}: ${e.message}`);
            }
        }, 800);
    }

    async checkForTickets() {
        const tickets = await this.page.$$eval(
            `[data-list-item-id*="channels___"]:has([class*="channelName"])`,
            (channels) => {
                return channels.map(ch => {
                    const channelId = ch.getAttribute('data-list-item-id')?.replace('channels___', '');
                    const channelName = ch.querySelector('[class*="channelName"]')?.innerText || '';
                    const hasButton = ch.querySelector('button, [role="button"]') !== null;
                    
                    return {
                        channelId,
                        channelName,
                        hasButton
                    };
                }).filter(t => t.hasButton && !t.channelName.includes('closed') && !t.channelName.includes('archived'));
            }
        );

        for (const ticket of tickets) {
            if (this.claimedChannels.has(ticket.channelId)) continue;
            if (this.currentTicket) return;

            console.log(`[FOUND_TICKET] ${ticket.channelName} (${ticket.channelId})`);
            
            await this.page.click(`[data-list-item-id="channels___${ticket.channelId}"]`);
            await this.page.waitForTimeout(500);
            
            const claimed = await this.findAndClickClaimButton();
            
            if (claimed) {
                this.currentTicket = ticket.channelId;
                this.claimedChannels.add(ticket.channelId);
                db.prepare('UPDATE users SET current_ticket = ? WHERE user_id = ?').run(ticket.channelId, this.userId);
                
                console.log(`[CLAIMED] ${this.userId} -> ${ticket.channelName}`);
                
                setTimeout(() => {
                    this.currentTicket = null;
                    db.prepare('UPDATE users SET current_ticket = NULL WHERE user_id = ?').run(this.userId);
                    console.log(`[RELEASED] ${this.userId}`);
                }, 120000);
                
                return;
            }
        }
    }

    async findAndClickClaimButton() {
        const claimButton = await this.page.$eval(
            'button:has-text("Claim"):not([disabled]), button:has-text("CLAIM"):not([disabled]), button:has-text("claim"):not([disabled])',
            btn => ({ text: btn.innerText, found: true })
        ).catch(() => null);

        if (claimButton) {
            console.log(`[FOUND_BTN] Text: ${claimButton.text}`);
            await this.page.click('button:has-text("Claim"):not([disabled])');
            await this.page.waitForTimeout(300);
            return true;
        }

        const buttons = await this.page.$$eval(
            '[class*="message"] button:not([disabled]), [class*="embed"] button:not([disabled])',
            btns => btns.map(b => ({
                text: b.innerText.toLowerCase(),
                emoji: b.querySelector('img')?.alt || ''
            }))
        );

        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const text = btn.text + btn.emoji;
            
            if (/(claim|accept|take|open|get)/i.test(text) && !/(close|delete|end)/i.test(text)) {
                console.log(`[FOUND_BTN] Index ${i}: ${text}`);
                
                const clickSuccess = await this.page.evaluate((index) => {
                    const btns = document.querySelectorAll('[class*="message"] button:not([disabled]), [class*="embed"] button:not([disabled])');
                    if (btns[index]) {
                        btns[index].click();
                        return true;
                    }
                    return false;
                }, i);

                if (clickSuccess) {
                    await this.page.waitForTimeout(300);
                    return true;
                }
            }
        }

        const emojiButtons = await this.page.$$eval(
            'button:has(img[alt="🎫"]):not([disabled]), button:has(img[alt="✅"]):not([disabled]), button:has(img[alt="📩"]):not([disabled])',
            btns => btns.length
        );

        if (emojiButtons > 0) {
            console.log(`[FOUND_EMOJI_BTN] ${emojiButtons} buttons`);
            await this.page.click('button:has(img[alt="🎫"]):not([disabled])').catch(() => 
                this.page.click('button:has(img[alt="✅"]):not([disabled])').catch(() => {})
            );
            await this.page.waitForTimeout(300);
            return true;
        }

        return false;
    }

    stop() {
        console.log(`[PUPPETEER_STOP] ${this.userId}`);
        
        this.isRunning = false;
        
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        
        if (this.browser) {
            try {
                this.browser.close();
            } catch (e) {
                const pid = db.prepare('SELECT browser_pid FROM users WHERE user_id = ?').get(this.userId)?.browser_pid;
                if (pid) {
                    try { process.kill(pid, 'SIGKILL'); } catch {}
                }
            }
            this.browser = null;
        }
        
        this.currentTicket = null;
        db.prepare('UPDATE users SET is_running = 0, current_ticket = NULL, browser_pid = NULL WHERE user_id = ?').run(this.userId);
        
        console.log(`[STOPPED] ${this.userId}`);
    }
}

async function validateToken(token) {
    try {
        const response = await fetch('https://discord.com/api/v9/users/@me', {
            headers: { 'Authorization': token }
        });
        if (!response.ok) throw new Error('Invalid token');
        const user = await response.json();
        return { valid: true, tag: `${user.username}#${user.discriminator}` };
    } catch (e) {
        return { valid: false, error: e.message };
    }
}

async function buildPanel(userId) {
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    if (!user) return null;
    
    const claimer = activeClaimers.get(userId);
    const running = claimer?.isRunning || false;
    const hasToken = !!(user.token && user.token.length > 10);
    const hasCategory = !!user.category_id;
    
    const embed = new EmbedBuilder()
        .setTitle('🎫 Ticket Claimer (Puppeteer)')
        .addFields(
            { name: 'Status', value: running ? '🟢 Running' : '🔴 Stopped', inline: true },
            { name: 'Token', value: hasToken ? '✅ Set' : '❌ Not set', inline: true },
            { name: 'Category', value: hasCategory ? '✅ Set' : '❌ Not set', inline: true },
            { name: 'Current', value: user.current_ticket || 'None', inline: true },
            { name: 'Last Error', value: user.last_error || 'None', inline: false }
        )
        .setColor(running ? 0x00FF00 : 0xFFA500)
        .setFooter({ text: 'Uses Puppeteer (real browser) - more reliable' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`token_${userId}`).setLabel('🔐 Token').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cat_${userId}`).setLabel('📁 Category').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`guild_${userId}`).setLabel('🏠 Guild').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`start_${userId}`).setLabel('▶️ Start').setStyle(ButtonStyle.Success).setDisabled(!hasToken || !hasCategory || running),
        new ButtonBuilder().setCustomId(`stop_${userId}`).setLabel('🛑 Stop').setStyle(ButtonStyle.Danger).setDisabled(!running)
    );

    return { embeds: [embed], components: [row] };
}

bot.on('interactionCreate', async (ix) => {
    if (ix.isCommand()) {
        try { await ix.deferReply({ ephemeral: true }); } catch { return; }

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
                const claimer = activeClaimers.get(uid);
                if (claimer) { claimer.stop(); activeClaimers.delete(uid); }
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
        if (ix.user.id !== uid) return ix.reply({ content: '❌ Not your panel', ephemeral: true });

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

        if (ix.customId.startsWith('guild_')) {
            return ix.showModal({
                title: 'Set Guild ID (Optional)',
                custom_id: `mod_guild_${uid}`,
                components: [{ type: 1, components: [{ type: 4, custom_id: 'val', label: 'Guild ID (optional)', style: 1, required: false }] }]
            });
        }

        if (ix.customId.startsWith('start_')) {
            console.log(`[START_BUTTON] ${uid}`);
            await ix.deferUpdate();
            
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
            if (!user?.token || !user?.category_id) {
                return ix.editReply({ content: '❌ Missing token or category', embeds: [], components: [] });
            }
            
            const existing = activeClaimers.get(uid);
            if (existing) existing.stop();
            
            const claimer = new PuppeteerClaimer(uid, user);
            activeClaimers.set(uid, claimer);
            await claimer.start();
            
            const panel = await buildPanel(uid);
            return ix.editReply(panel);
        }

        if (ix.customId.startsWith('stop_')) {
            console.log(`[STOP_BUTTON] ${uid}`);
            await ix.deferUpdate();
            
            const claimer = activeClaimers.get(uid);
            if (claimer) { 
                claimer.stop(); 
                activeClaimers.delete(uid); 
            }
            
            const panel = await buildPanel(uid);
            return ix.editReply(panel);
        }
    }

    if (ix.isModalSubmit()) {
        const uid = ix.customId.split('_').pop();
        if (ix.user.id !== uid) return ix.reply({ content: '❌ Not yours', ephemeral: true });

        const val = ix.fields.getTextInputValue('val');

        if (ix.customId.startsWith('mod_token_')) {
            console.log(`[TOKEN_MODAL] ${uid}`);
            await ix.deferReply({ ephemeral: true });
            
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
                content: `✅ Token validated: **${check.tag}**\n🔘 Set Category and click Start`,
                embeds: panel.embeds,
                components: panel.components
            });
        }

        if (ix.customId.startsWith('mod_cat_')) {
            console.log(`[CAT_MODAL] ${uid} | value: ${val}`);
            await ix.deferUpdate();
            
            db.prepare('UPDATE users SET category_id = ? WHERE user_id = ?').run(val, uid);
            
            const panel = await buildPanel(uid);
            return ix.editReply(panel);
        }

        if (ix.customId.startsWith('mod_guild_')) {
            console.log(`[GUILD_MODAL] ${uid} | value: ${val}`);
            await ix.deferUpdate();
            
            if (val) {
                db.prepare('UPDATE users SET guild_id = ? WHERE user_id = ?').run(val, uid);
            }
            
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
    for (const u of running) {
        db.prepare('UPDATE users SET is_running = 0, current_ticket = NULL, browser_pid = NULL WHERE user_id = ?').run(u.user_id);
    }
    
    console.log(`[READY] Cleaned up ${running.length} stale entries`);
});

process.on('SIGINT', () => {
    console.log('[SHUTDOWN] Cleaning up...');
    for (const [uid, claimer] of activeClaimers) {
        claimer.stop();
    }
    process.exit(0);
});

setInterval(() => {
    const mem = process.memoryUsage();
    console.log(`[HEALTH] RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Active Puppeteer: ${activeClaimers.size}`);
}, 300000);

bot.login(BOT_TOKEN);
