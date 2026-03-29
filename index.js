const { Client } = require('discord.js-selfbot-v13');

const client = new Client({
    checkUpdate: false
});

const CATEGORY_ID = process.env.CATEGORY_ID;
const USER_TOKEN = process.env.USER_TOKEN;

client.on('ready', () => {
    console.log(`[READY] ${client.user.tag}`);
    console.log(`[MONITOR] Category: ${CATEGORY_ID}`);
});

client.on('channelCreate', async (channel) => {
    if (channel.parentId !== CATEGORY_ID) return;
    
    console.log(`\n[NEW CHANNEL] ${channel.name}`);
    
    // Wait for ticket message
    await new Promise(r => setTimeout(r, 800));
    
    try {
        const messages = await channel.messages.fetch({ limit: 5 });
        console.log(`[FETCHED] ${messages.size} messages`);
        
        for (const [, msg] of messages) {
            await processMessage(msg);
        }
    } catch (e) {
        console.error(`[ERROR] ${e.message}`);
    }
});

client.on('messageCreate', async (message) => {
    if (message.channel.parentId !== CATEGORY_ID) return;
    await processMessage(message);
});

async function processMessage(message) {
    if (!message.components?.length) return;
    
    for (const row of message.components) {
        for (const btn of row.components) {
            // FIX: Check type as string "BUTTON" or number 2
            const isButton = btn.type === 2 || btn.type === "BUTTON";
            const label = (btn.label || '').toLowerCase();
            const isClaim = label.includes('claim');
            
            console.log(`[CHECK] Type:${btn.type} | IsButton:${isButton} | Label:"${btn.label}" | IsClaim:${isClaim}`);
            
            if (!isButton || !isClaim) continue;
            
            console.log(`[CLAIMING] ${btn.customId}`);
            
            try {
                await message.clickButton(btn.customId);
                console.log(`[SUCCESS] Claimed!`);
            } catch (e) {
                console.error(`[FAIL] ${e.message}`);
                
                // Fallback: try direct API
                try {
                    await message.client.api.interactions.post({
                        data: {
                            type: 3,
                            nonce: Date.now().toString(),
                            guild_id: message.guildId,
                            channel_id: message.channelId,
                            message_id: message.id,
                            application_id: message.applicationId || message.author.id,
                            session_id: message.client.sessionId,
                            data: {
                                component_type: 2,
                                custom_id: btn.customId
                            }
                        }
                    });
                    console.log(`[SUCCESS] Fallback API worked!`);
                } catch (e2) {
                    console.error(`[FALLBACK FAIL] ${e2.message}`);
                }
            }
        }
    }
}

client.login(USER_TOKEN);
